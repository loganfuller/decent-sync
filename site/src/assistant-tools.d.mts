export interface ReferenceTool {
  name: string;
  title: string;
  description: string;
  readOnly: boolean;
}
export const TOOLS_PAGE: { id: string; title: string; description: string };
export function readTools(): ReferenceTool[];
export function toolsBody(tools: ReferenceTool[]): string;
