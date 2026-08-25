import { relations } from "drizzle-orm";
import {
  account,
  agent,
  agentRun,
  agentSkill,
  agentSkillFile,
  codeInterpreterSession,
  planTask,
  project,
  projectAgent,
  projectMessage,
  projectSession,
  run,
  runEvent,
  runMessage,
  session,
  task,
  taskMessage,
  user,
} from "./schema";

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  projects: many(project),
  tasks: many(task),
  agents: many(agent),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, { fields: [session.userId], references: [user.id] }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, { fields: [account.userId], references: [user.id] }),
}));

export const projectRelations = relations(project, ({ one, many }) => ({
  owner: one(user, { fields: [project.ownerId], references: [user.id] }),
  projectAgents: many(projectAgent),
  leadTask: one(task, {
    fields: [project.leadTaskId],
    references: [task.id],
  }),
  runs: many(run),
  session: one(projectSession),
}));

export const agentRelations = relations(agent, ({ one, many }) => ({
  owner: one(user, { fields: [agent.userId], references: [user.id] }),
  projectAgents: many(projectAgent),
  skills: many(agentSkill),
}));

export const agentSkillRelations = relations(agentSkill, ({ one, many }) => ({
  agent: one(agent, { fields: [agentSkill.agentId], references: [agent.id] }),
  files: many(agentSkillFile),
}));

export const agentSkillFileRelations = relations(agentSkillFile, ({ one }) => ({
  skill: one(agentSkill, {
    fields: [agentSkillFile.skillId],
    references: [agentSkill.id],
  }),
}));

export const projectAgentRelations = relations(projectAgent, ({ one }) => ({
  project: one(project, {
    fields: [projectAgent.projectId],
    references: [project.id],
  }),
  agent: one(agent, {
    fields: [projectAgent.agentId],
    references: [agent.id],
  }),
  activeRun: one(run, {
    fields: [projectAgent.activeRunId],
    references: [run.id],
  }),
}));

export const taskRelations = relations(task, ({ one, many }) => ({
  user: one(user, { fields: [task.userId], references: [user.id] }),
  messages: many(taskMessage),
  runs: many(agentRun),
  codeInterpreterSessions: many(codeInterpreterSession),
}));

export const taskMessageRelations = relations(taskMessage, ({ one }) => ({
  task: one(task, { fields: [taskMessage.taskId], references: [task.id] }),
}));

export const agentRunRelations = relations(agentRun, ({ one }) => ({
  task: one(task, { fields: [agentRun.taskId], references: [task.id] }),
}));

export const codeInterpreterSessionRelations = relations(
  codeInterpreterSession,
  ({ one }) => ({
    task: one(task, {
      fields: [codeInterpreterSession.taskId],
      references: [task.id],
    }),
  }),
);

export const runRelations = relations(run, ({ one, many }) => ({
  parent: one(run, {
    fields: [run.parentRunId],
    references: [run.id],
    relationName: "runChildren",
  }),
  children: many(run, { relationName: "runChildren" }),
  task: one(task, { fields: [run.taskId], references: [task.id] }),
  project: one(project, { fields: [run.projectId], references: [project.id] }),
  planTasks: many(planTask, { relationName: "planTaskOwner" }),
  events: many(runEvent),
  messages: many(runMessage),
}));

export const planTaskRelations = relations(planTask, ({ one }) => ({
  run: one(run, {
    fields: [planTask.runId],
    references: [run.id],
    relationName: "planTaskOwner",
  }),
  childRun: one(run, {
    fields: [planTask.childRunId],
    references: [run.id],
    relationName: "planTaskChildRun",
  }),
}));

export const runEventRelations = relations(runEvent, ({ one }) => ({
  run: one(run, { fields: [runEvent.runId], references: [run.id] }),
}));

export const runMessageRelations = relations(runMessage, ({ one }) => ({
  run: one(run, { fields: [runMessage.runId], references: [run.id] }),
}));

export const projectSessionRelations = relations(
  projectSession,
  ({ one, many }) => ({
    project: one(project, {
      fields: [projectSession.projectId],
      references: [project.id],
    }),
    messages: many(projectMessage),
  }),
);

export const projectMessageRelations = relations(projectMessage, ({ one }) => ({
  session: one(projectSession, {
    fields: [projectMessage.sessionId],
    references: [projectSession.id],
  }),
}));
