export interface PluginDefinition { id: string; name: string; description: string; capabilities: string[]; prefix: string; probe?: string }
export const pluginDefinitions: PluginDefinition[];
export function definition(id: string): PluginDefinition;
export function assertPluginEnabled(id: string, env?: NodeJS.ProcessEnv): void;
