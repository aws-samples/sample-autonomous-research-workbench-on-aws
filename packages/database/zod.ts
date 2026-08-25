import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import {
  account,
  agent,
  agentSkill,
  agentSkillFile,
  codeInterpreterSession,
  extractionTemplate,
  planTask,
  project,
  projectAgent,
  run,
  runEvent,
  runMessage,
  session,
  task,
  taskMessage,
  user,
  verification,
} from "./schema";

// ── Select schemas (for reading/querying) ──

export const userSelectSchema = createSelectSchema(user);
export const sessionSelectSchema = createSelectSchema(session);
export const accountSelectSchema = createSelectSchema(account);
export const verificationSelectSchema = createSelectSchema(verification);
export const projectSelectSchema = createSelectSchema(project);
export const agentSelectSchema = createSelectSchema(agent);
export const agentSkillSelectSchema = createSelectSchema(agentSkill);
export const agentSkillFileSelectSchema = createSelectSchema(agentSkillFile);
export const projectAgentSelectSchema = createSelectSchema(projectAgent);
export const taskSelectSchema = createSelectSchema(task);
export const taskMessageSelectSchema = createSelectSchema(taskMessage);
export const codeInterpreterSessionSelectSchema = createSelectSchema(
  codeInterpreterSession,
);
export const runSelectSchema = createSelectSchema(run);
export const planTaskSelectSchema = createSelectSchema(planTask);
export const runEventSelectSchema = createSelectSchema(runEvent);
export const runMessageSelectSchema = createSelectSchema(runMessage);
export const extractionTemplateSelectSchema =
  createSelectSchema(extractionTemplate);

// ── Insert schemas (for creating) ──

export const userInsertSchema = createInsertSchema(user);
export const sessionInsertSchema = createInsertSchema(session);
export const accountInsertSchema = createInsertSchema(account);
export const verificationInsertSchema = createInsertSchema(verification);
export const projectInsertSchema = createInsertSchema(project);
export const agentInsertSchema = createInsertSchema(agent);
export const agentSkillInsertSchema = createInsertSchema(agentSkill);
export const agentSkillFileInsertSchema = createInsertSchema(agentSkillFile);
export const projectAgentInsertSchema = createInsertSchema(projectAgent);
export const taskInsertSchema = createInsertSchema(task);
export const taskMessageInsertSchema = createInsertSchema(taskMessage);
export const codeInterpreterSessionInsertSchema = createInsertSchema(
  codeInterpreterSession,
);
export const runInsertSchema = createInsertSchema(run);
export const planTaskInsertSchema = createInsertSchema(planTask);
export const runEventInsertSchema = createInsertSchema(runEvent);
export const runMessageInsertSchema = createInsertSchema(runMessage);
export const extractionTemplateInsertSchema =
  createInsertSchema(extractionTemplate);
