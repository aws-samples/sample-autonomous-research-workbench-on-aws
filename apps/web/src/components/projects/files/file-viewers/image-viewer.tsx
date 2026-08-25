import { RotateCcw, ZoomIn, ZoomOut } from "lucide-react";
import {
	TransformComponent,
	TransformWrapper,
	useControls,
} from "react-zoom-pan-pinch";

import type { FileViewerProps } from "./index";

function Controls() {
	const { zoomIn, zoomOut, resetTransform } = useControls();

	return (
		<div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1 rounded-md bg-muted px-1.5 py-1">
			<button
				type="button"
				onClick={() => zoomOut()}
				className="rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
			>
				<ZoomOut className="h-4 w-4" />
			</button>
			<button
				type="button"
				onClick={() => resetTransform()}
				className="rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
			>
				<RotateCcw className="h-4 w-4" />
			</button>
			<button
				type="button"
				onClick={() => zoomIn()}
				className="rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
			>
				<ZoomIn className="h-4 w-4" />
			</button>
		</div>
	);
}

/** `content` is the presigned GET URL for the image. */
export function ImageViewer({ content, fileName }: FileViewerProps) {
	return (
		<div className="relative h-full w-full bg-muted/30">
			<TransformWrapper
				initialScale={1}
				minScale={0.1}
				maxScale={10}
				centerOnInit
				doubleClick={{ mode: "reset" }}
				wheel={{ step: 0.05 }}
			>
				<Controls />
				<TransformComponent
					wrapperStyle={{ width: "100%", height: "100%" }}
					contentStyle={{
						width: "100%",
						height: "100%",
						display: "flex",
						alignItems: "center",
						justifyContent: "center",
					}}
				>
					<img
						src={content}
						alt={fileName}
						className="max-w-full max-h-full object-contain"
						draggable={false}
					/>
				</TransformComponent>
			</TransformWrapper>
		</div>
	);
}
