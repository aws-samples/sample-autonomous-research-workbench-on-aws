import type { FileViewerProps } from "./index";

export function RawViewer({ content }: FileViewerProps) {
	return (
		<pre className="p-4 text-xs font-mono whitespace-pre-wrap wrap-break-word leading-relaxed">
			{content}
		</pre>
	);
}
