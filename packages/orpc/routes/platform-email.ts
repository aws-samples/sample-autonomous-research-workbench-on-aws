import {
  GetEmailIdentityCommand,
  ListEmailIdentitiesCommand,
  SESv2Client,
} from '@aws-sdk/client-sesv2'
import * as z from 'zod'

import { authorized } from '../context'

/**
 * Platform email sending identity, backed directly by Amazon SES v2 — no
 * local storage and read-only from the app. Identities (domains or individual
 * email addresses) are created and verified in the AWS console; the SES
 * account is the source of truth. The first listed identity is treated as the
 * platform sender (projects will read it the same way). When no identity
 * exists, email sending is not allowed.
 */

let cachedSes: SESv2Client | null = null
function ses(): SESv2Client {
  cachedSes ??= new SESv2Client({
    customUserAgent: process.env.USER_AGENT_STRING,
  })
  return cachedSes
}

const IDENTITY_TYPES = ['DOMAIN', 'EMAIL_ADDRESS'] as const

const SendingIdentity = z.object({
  /** The domain (e.g. "example.com") or email address ("me@example.com"). */
  identity: z.string(),
  type: z.enum(IDENTITY_TYPES),
  /** SES VerificationStatus, e.g. SUCCESS | PENDING | FAILED. */
  verificationStatus: z.string(),
  /** Whether SES will accept sends from this identity. */
  sendingEnabled: z.boolean(),
})

const ListOutput = z.object({
  /** The platform sender: the first SES identity, if any. */
  sender: SendingIdentity.nullable(),
  identities: z.array(SendingIdentity),
  /** AWS region the SES identities live in (for console deep links). */
  region: z.string(),
})

type IdentityType = (typeof IDENTITY_TYPES)[number]

async function listIdentityNames(): Promise<
  { name: string; type: IdentityType }[]
> {
  const identities: { name: string; type: IdentityType }[] = []
  let nextToken: string | undefined
  do {
    const page = await ses().send(
      new ListEmailIdentitiesCommand({ NextToken: nextToken }),
    )
    for (const identity of page.EmailIdentities ?? []) {
      if (
        identity.IdentityName &&
        (identity.IdentityType === 'DOMAIN' ||
          identity.IdentityType === 'EMAIL_ADDRESS')
      ) {
        identities.push({
          name: identity.IdentityName,
          type: identity.IdentityType,
        })
      }
    }
    nextToken = page.NextToken
  } while (nextToken)
  return identities
}

async function describeIdentity(entry: {
  name: string
  type: IdentityType
}): Promise<z.infer<typeof SendingIdentity>> {
  const detail = await ses().send(
    new GetEmailIdentityCommand({ EmailIdentity: entry.name }),
  )
  return {
    identity: entry.name,
    type: entry.type,
    verificationStatus: detail.VerificationStatus ?? 'PENDING',
    sendingEnabled: detail.VerifiedForSendingStatus ?? false,
  }
}

export const listSendingIdentities = authorized
  .route({
    method: 'GET',
    path: '/platform/sending-identities',
    tags: ['Platform'],
    description:
      'List the SES v2 identities (domains and email addresses). The first identity is the platform sender; when none exist, email sending is not allowed. Identities are managed in the AWS console.',
  })
  .output(ListOutput)
  .handler(async () => {
    const [names, region] = await Promise.all([
      listIdentityNames(),
      ses().config.region(),
    ])
    const identities = await Promise.all(names.map(describeIdentity))
    return {
      sender: identities[0] ?? null,
      identities,
      region,
    }
  })
