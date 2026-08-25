import { client } from "@/orpc/client";

// =============================================================================
// Types
// =============================================================================

export interface FileEntry {
	name: string;
	isDir: boolean;
	size: number;
	modTime: string;
}

export interface UploadFileMeta {
	name: string;
	contentType?: string;
	size: number;
}

/**
 * Backend adapter for the generic file browser. Implementations map the
 * browser's operations onto a concrete oRPC route family (project files,
 * artifact files, ...). `scopeKey` namespaces react-query caches so
 * different scopes never collide.
 */
export interface FileBrowserApi {
	scopeKey: readonly unknown[];
	list(path: string): Promise<{ files: FileEntry[] }>;
	createFolder(path: string): Promise<unknown>;
	delete(path: string, isDir: boolean): Promise<unknown>;
	presignUpload(
		path: string,
		files: UploadFileMeta[],
	): Promise<{ uploads: { name: string; url: string }[] }>;
	presignDownload(
		path: string,
		download?: boolean,
	): Promise<{ url: string; fileName: string }>;
}

// =============================================================================
// Query keys
// =============================================================================

export function fileListQueryKey(api: FileBrowserApi, path: string) {
	return [...api.scopeKey, "files", "list", path] as const;
}

export function filePresignQueryKey(api: FileBrowserApi, path: string) {
	return [...api.scopeKey, "files", "presign", path] as const;
}

export function fileContentQueryKey(api: FileBrowserApi, path: string) {
	return [...api.scopeKey, "files", "content", path] as const;
}

// =============================================================================
// Adapters
// =============================================================================

/** File browser scoped to a project's `projects/{projectId}/` prefix. */
export function createProjectFilesApi(projectId: string): FileBrowserApi {
	return {
		scopeKey: ["project-files", projectId],
		list: (path) => client.projects.files.list({ projectId, path }),
		createFolder: (path) =>
			client.projects.files.createFolder({ projectId, path }),
		delete: (path, isDir) =>
			client.projects.files.delete({ projectId, path, isDir }),
		presignUpload: (path, files) =>
			client.projects.files.presignUpload({ projectId, path, files }),
		presignDownload: (path, download = false) =>
			client.projects.files.presignDownload({ projectId, path, download }),
	};
}

/** File browser over the whole artifacts bucket, from its root. */
export function createArtifactFilesApi(): FileBrowserApi {
	return {
		scopeKey: ["artifact-files"],
		list: (path) => client.artifacts.files.list({ path }),
		createFolder: (path) => client.artifacts.files.createFolder({ path }),
		delete: (path, isDir) => client.artifacts.files.delete({ path, isDir }),
		presignUpload: (path, files) =>
			client.artifacts.files.presignUpload({ path, files }),
		presignDownload: (path, download = false) =>
			client.artifacts.files.presignDownload({ path, download }),
	};
}
