export interface LogScrollViewport {
  scrollHeight: number;
  scrollTop: number;
}

export function scrollLogViewportToTail(viewport: LogScrollViewport) {
  viewport.scrollTop = viewport.scrollHeight;
}
