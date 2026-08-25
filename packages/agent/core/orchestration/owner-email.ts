import {
  ListEmailIdentitiesCommand,
  SendEmailCommand,
  SESv2Client,
} from "@aws-sdk/client-sesv2";
import { db, eq, project, user } from "@repo/database";

/**
 * Owner notification emails, sent by the Team Lead over Amazon SES v2.
 *
 * Safety properties, enforced here rather than left to the LLM:
 * - The recipient is ALWAYS the project owner's account email, resolved from
 *   the project row — the model never supplies an address.
 * - The sender is the platform sending identity: the first identity in the
 *   SES account (same convention as the Settings → Email page). A domain
 *   identity sends as no-reply@<domain>; an email-address identity sends as
 *   itself. When no verified identity exists, sending is not allowed and the
 *   tool reports why instead of sending.
 */

export type OwnerEmailScenario = "pause_awaiting_guidance" | "project_completed";

/** Local part used when the platform sender is a domain identity. */
const DOMAIN_SENDER_LOCAL_PART = "no-reply";

let cachedSes: SESv2Client | null = null;
function ses(): SESv2Client {
  cachedSes ??= new SESv2Client({
    customUserAgent: process.env.USER_AGENT_STRING,
  });
  return cachedSes;
}

/** Public web origin for project links (set by infra; localhost in dev). */
function appBaseUrl(): string {
  return (process.env.PUBLIC_APP_URL ?? "http://localhost:3000").replace(
    /\/+$/,
    "",
  );
}

/**
 * Resolve the platform sender from SES: the first domain or email-address
 * identity. Mirrors the convention of the platform settings Email tab.
 */
async function resolveSender(): Promise<
  { ok: true; from: string } | { ok: false; reason: string }
> {
  const page = await ses().send(new ListEmailIdentitiesCommand({}));
  const first = (page.EmailIdentities ?? []).find(
    (i) =>
      i.IdentityName &&
      (i.IdentityType === "DOMAIN" || i.IdentityType === "EMAIL_ADDRESS"),
  );
  if (!first?.IdentityName) {
    return {
      ok: false,
      reason:
        "Email sending is not allowed: no SES sending identity is configured for the platform.",
    };
  }
  if (!first.SendingEnabled) {
    return {
      ok: false,
      reason: `Email sending is not allowed: the platform sending identity "${first.IdentityName}" is not verified for sending yet.`,
    };
  }
  return {
    ok: true,
    from:
      first.IdentityType === "DOMAIN"
        ? `${DOMAIN_SENDER_LOCAL_PART}@${first.IdentityName}`
        : first.IdentityName,
  };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildContent(args: {
  scenario: OwnerEmailScenario;
  projectName: string;
  ownerName: string;
  reason: string;
  details?: string;
  projectUrl: string;
}): { subject: string; text: string; html: string } {
  const { scenario, projectName, ownerName, reason, details, projectUrl } =
    args;

  const heading =
    scenario === "pause_awaiting_guidance"
      ? `Work on "${projectName}" is paused, awaiting your guidance.`
      : `The project "${projectName}" has been completed.`;

  const subject =
    scenario === "pause_awaiting_guidance"
      ? `[${projectName}] Paused — your guidance is needed`
      : `[${projectName}] Project completed`;

  const followUp =
    scenario === "pause_awaiting_guidance"
      ? "Open the project and reply to the Team Lead to resume work."
      : "You can review the outcome in the project, and reopen it from project settings if further work is needed.";

  const textParts = [
    `Hi ${ownerName},`,
    heading,
    `Reason: ${reason}`,
    ...(details ? [details] : []),
    `Project: ${projectUrl}`,
    followUp,
    "— Team Lead",
  ];

  const htmlParts = [
    `<p>Hi ${escapeHtml(ownerName)},</p>`,
    `<p>${escapeHtml(heading)}</p>`,
    `<p><strong>Reason:</strong> ${escapeHtml(reason)}</p>`,
    ...(details ? [`<p>${escapeHtml(details)}</p>`] : []),
    `<p><a href="${escapeHtml(projectUrl)}">Open the project</a></p>`,
    `<p>${escapeHtml(followUp)}</p>`,
    `<p>— Team Lead</p>`,
  ];

  return {
    subject,
    text: textParts.join("\n\n"),
    html: htmlParts.join("\n"),
  };
}

export type SendOwnerEmailResult =
  | { sent: true; to: string; from: string; subject: string }
  | { sent: false; reason: string };

/**
 * Email the project's owner about a pause-awaiting-guidance or a completion.
 * Resolves recipient, sender, and project link itself; the caller only
 * supplies the scenario and the human-readable reasoning.
 */
export async function sendOwnerEmail(args: {
  projectId: string;
  scenario: OwnerEmailScenario;
  reason: string;
  details?: string;
}): Promise<SendOwnerEmailResult> {
  const projectRow = await db.query.project.findFirst({
    where: eq(project.id, args.projectId),
    columns: { name: true, ownerId: true },
  });
  if (!projectRow) return { sent: false, reason: "Project not found." };

  const owner = await db.query.user.findFirst({
    where: eq(user.id, projectRow.ownerId),
    columns: { name: true, email: true },
  });
  if (!owner?.email) {
    return { sent: false, reason: "Project owner has no email address." };
  }

  const sender = await resolveSender();
  if (!sender.ok) return { sent: false, reason: sender.reason };

  const { subject, text, html } = buildContent({
    scenario: args.scenario,
    projectName: projectRow.name,
    ownerName: owner.name,
    reason: args.reason,
    details: args.details,
    projectUrl: `${appBaseUrl()}/projects/${args.projectId}`,
  });

  await ses().send(
    new SendEmailCommand({
      FromEmailAddress: sender.from,
      Destination: { ToAddresses: [owner.email] },
      Content: {
        Simple: {
          Subject: { Data: subject, Charset: "UTF-8" },
          Body: {
            Text: { Data: text, Charset: "UTF-8" },
            Html: { Data: html, Charset: "UTF-8" },
          },
        },
      },
    }),
  );

  return { sent: true, to: owner.email, from: sender.from, subject };
}
