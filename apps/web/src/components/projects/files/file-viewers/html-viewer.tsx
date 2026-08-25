import { useMemo } from "react";

import type { FileViewerProps } from "./index";

export function HtmlViewer({ content }: FileViewerProps) {
	const srcDoc = useMemo(() => content, [content]);

	return (
		<iframe
			srcDoc={srcDoc}
			sandbox="allow-scripts allow-same-origin"
			className="w-full h-full border-0 bg-white"
			title="HTML Preview"
		/>
	);
}
