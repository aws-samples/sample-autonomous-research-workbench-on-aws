import type { ComponentType } from "react";

import { HtmlViewer } from "./html-viewer";
import { ImageViewer } from "./image-viewer";
import { RawViewer } from "./raw-viewer";

export interface FileViewerProps {
	/**
	 * Viewer payload: text content for text-based viewers, or the presigned
	 * GET URL for binary viewers (images).
	 */
	content: string;
	fileName: string;
}

type FileViewerComponent = ComponentType<FileViewerProps>;

/**
 * Registry mapping file extensions to their viewer components.
 * To add support for a new file type, simply add an entry here
 * and create the corresponding viewer component.
 */
const FILE_VIEWER_MAP: Record<string, FileViewerComponent> = {
	".html": HtmlViewer,
	".htm": HtmlViewer,
	".png": ImageViewer,
	".jpg": ImageViewer,
	".jpeg": ImageViewer,
	".gif": ImageViewer,
	".webp": ImageViewer,
	".svg": ImageViewer,
	".ico": ImageViewer,
	".bmp": ImageViewer,
};

/**
 * Extensions rendered straight from the presigned URL instead of
 * being fetched as text.
 */
const BINARY_EXTENSIONS = new Set([
	".png",
	".jpg",
	".jpeg",
	".gif",
	".webp",
	".svg",
	".ico",
	".bmp",
]);

/**
 * Returns true if the file should be rendered from its presigned URL
 * rather than fetched as text.
 */
export function isBinaryFile(fileName: string): boolean {
	const ext = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
	return BINARY_EXTENSIONS.has(ext);
}

/**
 * Returns the appropriate viewer component for a given file name.
 * Falls back to RawViewer for unrecognized extensions.
 */
export function getFileViewer(fileName: string): FileViewerComponent {
	const ext = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
	return FILE_VIEWER_MAP[ext] ?? RawViewer;
}
