export interface SkillRecord { name: string; source: string; digest: string; enabled: boolean; files: Record<string, string>; }

export interface ResourceView {
  skills: Array<SkillRecord & { loaded: boolean; description?: string; error?: string }>;
  catalog?: { path: string; enabled: boolean; count: number; error?: string };
  diagnostics: string[];
  tools: string[];
}

export interface ResourceImportRequest { workspaceId: string; kind: "skill" | "catalog"; path: string; }

export interface ResourceToggleRequest { workspaceId: string; name: string; enabled: boolean; }
