import {
  createAgent,
  deleteAgent,
  deleteSkill,
  duplicateAgent,
  getAgent,
  getSkillFile,
  getToolCatalog,
  listAgents,
  listSkills,
  updateAgent,
  uploadSkill,
} from './routes/agents'
import {
  createFolder as createArtifactFolder,
  deleteFile as deleteArtifactFile,
  listFiles as listArtifactFiles,
  presignDownload as presignArtifactDownload,
  presignUpload as presignArtifactUpload,
} from './routes/artifact-files'
import {
  clearGraph,
  getGraph,
  getHypothesisStats,
  getProjectGraph,
  getSchema,
  getStats,
} from './routes/graph'
import {
  getTemplate,
  resetTemplate,
  saveTemplate,
} from './routes/graph-template'
import {
  deleteFile,
  getDownloadUrl,
  getUploadUrl,
  listFiles,
  startSync,
  syncStatus,
} from './routes/knowledge'
import {
  activateProject,
  activeProjectCount,
  createProject,
  deleteProject,
  getProject,
  getProjectHeartbeat,
  listProjects,
  listRecentProjects,
  projectMetrics,
  updateProject,
  updateProjectHeartbeat,
} from './routes/projects'
import {
  getLeadThread,
  listAgents as listProjectAgents,
  sendLeadMessage,
  startAgent,
  stopAgent,
} from './routes/project-agents'
import {
  createFolder as createProjectFolder,
  deleteFile as deleteProjectFile,
  listFiles as listProjectFiles,
  presignDownload as presignProjectDownload,
  presignUpload as presignProjectUpload,
} from './routes/project-files'
import { listSendingIdentities } from './routes/platform-email'
import { prospectChat, prospectHarness, prospectHistory } from './routes/prospect'
import { getRunStatus, listRunEvents, listRuns, startRun } from './routes/runs'

export const router = {
  agents: {
    list: listAgents,
    get: getAgent,
    create: createAgent,
    update: updateAgent,
    delete: deleteAgent,
    duplicate: duplicateAgent,
    toolCatalog: getToolCatalog,
    skills: {
      list: listSkills,
      getFile: getSkillFile,
      upload: uploadSkill,
      delete: deleteSkill,
    },
  },
  artifacts: {
    files: {
      list: listArtifactFiles,
      createFolder: createArtifactFolder,
      delete: deleteArtifactFile,
      presignUpload: presignArtifactUpload,
      presignDownload: presignArtifactDownload,
    },
  },
  graph: {
    getSchema,
    getGraph,
    getProjectGraph,
    getStats,
    getHypothesisStats,
    clearGraph,
    getTemplate,
    saveTemplate,
    resetTemplate,
  },
  knowledge: {
    listFiles,
    getUploadUrl,
    getDownloadUrl,
    deleteFile,
    startSync,
    syncStatus,
  },
  platform: {
    sendingIdentities: listSendingIdentities,
  },
  projects: {
    list: listProjects,
    listRecent: listRecentProjects,
    activeCount: activeProjectCount,
    create: createProject,
    get: getProject,
    update: updateProject,
    metrics: projectMetrics,
    activate: activateProject,
    delete: deleteProject,
    heartbeat: {
      get: getProjectHeartbeat,
      update: updateProjectHeartbeat,
    },
    agents: {
      list: listProjectAgents,
      start: startAgent,
      stop: stopAgent,
    },
    files: {
      list: listProjectFiles,
      createFolder: createProjectFolder,
      delete: deleteProjectFile,
      presignUpload: presignProjectUpload,
      presignDownload: presignProjectDownload,
    },
    lead: {
      get: getLeadThread,
      send: sendLeadMessage,
    },
    prospect: {
      history: prospectHistory,
      chat: prospectChat,
      harness: prospectHarness,
    },
  },
  runs: {
    start: startRun,
    get: getRunStatus,
    events: listRunEvents,
    list: listRuns,
  },
}
