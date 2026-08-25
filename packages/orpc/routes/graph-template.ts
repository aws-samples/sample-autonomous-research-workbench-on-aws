import { db, eq, extractionTemplate } from '@repo/database'
import * as z from 'zod'

import { admin, authorized } from '../context'
import {
  DEFAULT_EXTRACTION_TEMPLATE,
  DEFAULT_TEMPLATE_NAME,
} from './extraction-template.default'

/**
 * The editable entity/relation extraction template shown in the Platform
 * Graph → Schema tab. A single platform-wide row (name = "default") holds the
 * current template; when no row exists yet the bundled
 * DEFAULT_EXTRACTION_TEMPLATE is returned so the UI always has something to
 * show. Reads are open to any signed-in user; writes are admin-only.
 */

const ENTRY_TYPES = ['actor', 'feature', 'relation'] as const

const TemplateEntry = z.object({
  type: z.enum(ENTRY_TYPES),
  tokens: z.array(z.string().min(1).max(200)).max(500),
})

/**
 * The template is a map of entry name -> entry. Entry names are the graph
 * labels/relationship types, so they're constrained to a safe identifier-ish
 * shape rather than free text.
 */
const TemplateSchema = z.record(
  z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-z0-9][a-z0-9_-]*$/i, {
      message:
        'Entry names must start alphanumeric and contain only letters, numbers, "_" or "-"',
    }),
  TemplateEntry,
)

export type ExtractionTemplate = z.infer<typeof TemplateSchema>

const TemplateOutput = z.object({
  name: z.string(),
  template: TemplateSchema,
  isDefault: z.boolean(),
  updatedAt: z.string().nullable(),
})

async function loadDefaultRow() {
  return db.query.extractionTemplate.findFirst({
    where: eq(extractionTemplate.name, DEFAULT_TEMPLATE_NAME),
  })
}

export const getTemplate = authorized
  .route({
    method: 'GET',
    path: '/graph/template',
    tags: ['Graph'],
    description:
      'Get the current entity/relation extraction template, falling back to the platform default when none has been saved.',
  })
  .output(TemplateOutput)
  .handler(async () => {
    const row = await loadDefaultRow()
    if (!row) {
      return {
        name: DEFAULT_TEMPLATE_NAME,
        template: DEFAULT_EXTRACTION_TEMPLATE as unknown as ExtractionTemplate,
        isDefault: true,
        updatedAt: null,
      }
    }
    return {
      name: row.name,
      template: row.template as ExtractionTemplate,
      isDefault: false,
      updatedAt: row.updatedAt.toISOString(),
    }
  })

export const saveTemplate = admin
  .route({
    method: 'POST',
    path: '/graph/template',
    tags: ['Graph'],
    description: 'Persist an edited extraction template (upserts the default row).',
  })
  .input(z.object({ template: TemplateSchema }))
  .output(TemplateOutput)
  .handler(async ({ input, context }) => {
    const [row] = await db
      .insert(extractionTemplate)
      .values({
        name: DEFAULT_TEMPLATE_NAME,
        template: input.template,
        updatedBy: context.user.id,
      })
      .onConflictDoUpdate({
        target: extractionTemplate.name,
        set: {
          template: input.template,
          updatedBy: context.user.id,
        },
      })
      .returning()

    return {
      name: row!.name,
      template: row!.template as ExtractionTemplate,
      isDefault: false,
      updatedAt: row!.updatedAt.toISOString(),
    }
  })

export const resetTemplate = admin
  .route({
    method: 'POST',
    path: '/graph/template/reset',
    tags: ['Graph'],
    description:
      'Delete the saved template so the platform default is served again.',
  })
  .output(TemplateOutput)
  .handler(async () => {
    await db
      .delete(extractionTemplate)
      .where(eq(extractionTemplate.name, DEFAULT_TEMPLATE_NAME))

    return {
      name: DEFAULT_TEMPLATE_NAME,
      template: DEFAULT_EXTRACTION_TEMPLATE as unknown as ExtractionTemplate,
      isDefault: true,
      updatedAt: null,
    }
  })
