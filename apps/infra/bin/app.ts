#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import { PrototypeSecurityNagPack } from "./prototype-security";

import { InfraStack } from "../lib/infra-stack";
import { NAG_ACKNOWLEDGEMENTS } from "../lib/nag-acknowledgements";
import { suppressNagFindings } from "../lib/nag-suppressions";
import { SOLUTION_ID, UserAgentAspect } from "../lib/solution";

import "source-map-support/register";

const app = new cdk.App();
new InfraStack(app, "ResearchWorkbench", {
  description: `Autonomous Research Workbench prototype (${SOLUTION_ID})`,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  // isProd: true,
});


// AwsSolutions checks plus the prototype-specific pack, minus the findings
// acknowledged (with evidence) in lib/nag-acknowledgements.ts. Any ERROR not
// listed there fails synthesis; WARNs are reported but non-blocking.
cdk.Validations.of(app).addPlugins(
  ...suppressNagFindings(
    [
      new AwsSolutionsChecks(app, { verbose: true }),
      new PrototypeSecurityNagPack(app, { verbose: true }),
    ],
    NAG_ACKNOWLEDGEMENTS,
  ),
);

cdk.Aspects.of(app).add(new UserAgentAspect());

app.synth();
