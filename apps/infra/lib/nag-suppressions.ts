import * as cdk from 'aws-cdk-lib';
import type { NagPack } from 'cdk-nag';

/**
 * One acknowledged cdk-nag finding: which construct(s) it applies to, which
 * rule, and why the finding is acceptable.
 */
export interface NagAcknowledgement {
  /**
   * Substring or regex matched against the violating construct path, e.g.
   * `'Ingestion/ExtractFunction/ServiceRole'`. A string matches if it appears
   * anywhere in the path, so it can be as broad or as narrow as the evidence
   * warrants.
   */
  readonly path: string | RegExp;
  /**
   * Substring or regex matched against the cdk-nag finding ID, e.g.
   * `'AwsSolutions-IAM5[Action::s3:'` or `/^AwsSolutions-IAM4\[/`.
   */
  readonly rule: string | RegExp;
  /** Why this is acceptable — shows up in the audit report. */
  readonly reason: string;
}

const matches = (pattern: string | RegExp, value: string): boolean =>
  typeof pattern === 'string' ? value.includes(pattern) : pattern.test(value);

/**
 * Wraps cdk-nag packs so listed findings are dropped from their reports, and
 * returns one plugin per pack to spread into `Validations.addPlugins()`. All
 * packs share one acknowledgement list, so a suppression is reported stale only
 * when no pack matched it.
 *
 * ## Why not `Validations.of(scope).acknowledge()`?
 *
 * Two reasons, both blocking:
 *
 * 1. **It throws on most IAM findings.** `acknowledge()` runs the ID through a
 *    `qualifyId()` check that rejects anything containing more than one `::`.
 *    cdk-nag's IAM findings routinely contain several —
 *    `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:logs:...:log-group:*]`,
 *    `AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/...]` —
 *    so passing one in raises `InvalidValidationId` and fails synthesis. That
 *    covers 60 of this app's ~188 findings.
 * 2. **Matching is exact-string.** The remaining IDs embed the resolved account
 *    ID and region (`...:<region>:<account-id>:...`) plus CDK-generated export
 *    hashes, so a literal list would silently stop suppressing the moment the
 *    app is deployed to another account or a logical ID shifts.
 *
 * Filtering the report instead lets suppressions be written against stable
 * construct paths and rule prefixes, and keeps every one of them paired with a
 * reason in a single reviewable list.
 */
export function suppressNagFindings(
  packs: readonly NagPack[],
  acknowledgements: readonly NagAcknowledgement[],
): cdk.IPolicyValidationPlugin[] {
  // Shared across every pack: an acknowledgement is only stale if *no* pack
  // matched it, and the report is only emitted once the last pack has run.
  const used = new Set<NagAcknowledgement>();
  let remainingPacks = packs.length;

  return packs.map((pack) => ({
    name: pack.readPackName,
    validate(context: cdk.IPolicyValidationContext): cdk.PolicyValidationPluginReport {
      const report = pack.validate(context);

      const violations: cdk.PolicyViolation[] = [];
      for (const violation of report.violations) {
        // A violation groups every construct that broke one rule, so filter the
        // resource list and keep the violation only if something is left.
        const remaining = violation.violatingResources.filter((resource) => {
          const path = resource.constructPath ?? resource.resourceLogicalId ?? '';
          const ack = acknowledgements.find(
            (a) => matches(a.rule, violation.ruleName) && matches(a.path, path),
          );
          if (ack) used.add(ack);
          return !ack;
        });
        if (remaining.length > 0) {
          violations.push({ ...violation, violatingResources: remaining });
        }
      }

      // Surface acknowledgements that no longer match anything: the underlying
      // policy or resource was probably tightened or renamed, and a suppression
      // that silently covers nothing is how stale exceptions accumulate.
      // Written straight to stderr because construct annotations added during
      // validation are ignored — the tree is already finalized by this point.
      const stale = --remainingPacks === 0
        ? acknowledgements.filter((a) => !used.has(a))
        : [];
      if (stale.length > 0) {
        const describe = (p: string | RegExp) => (typeof p === 'string' ? p : String(p));
        console.warn(
          `\n[cdk-nag] ${stale.length} suppression(s) in lib/nag-acknowledgements.ts matched no ` +
            'finding and can be removed:\n' +
            stale.map((a) => `  - ${describe(a.rule)} @ ${describe(a.path)}`).join('\n') +
            '\n',
        );
      }

      // cdk-nag v3 fails the report on any violation at all, so a WARN-level
      // rule blocks synthesis where in v2 it was only an annotation. Warnings
      // here are advisory (missing VPC endpoints, no Bedrock guardrail), so
      // keep them visible in the report but only let ERROR fail the build —
      // the same severity test CDK itself applies to acknowledged violations.
      const fatal = (v: cdk.PolicyViolation) =>
        v.severity === 'error' || v.severity === 'fatal';

      return {
        ...report,
        success: !violations.some(fatal),
        violations,
      };
    },
  }));
}
