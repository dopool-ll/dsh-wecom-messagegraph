import { createContext, useContext } from 'react';
import type { DatabaseExport, Request } from '../../../packages/wecom-core/src/types';
import type { SourceLink } from './AgentMemory';

type AgentRequest = {op: `agent${string}`; workspace?: string | null; [key: string]: unknown};
export type CopilotMode = 'summary' | 'actions' | 'question';
export type CopilotRequest = {profile: string; conversation: string; workspace?: string; mode: CopilotMode;
  question?: string; previousQuestions: string[]};
export type CopilotAnswer = {answer: string; citations: {number: number; source: SourceLink}[]};
export type CopilotProgress = {type: 'generating'} | {type: 'delta'; text: string};

export interface WeComTransport {
  request<T>(request: Request | AgentRequest, signal?: AbortSignal): Promise<T>;
  askCopilot(request: CopilotRequest, progress: (event: CopilotProgress) => void, signal: AbortSignal): Promise<CopilotAnswer>;
  exportDatabases(profile: string): Promise<DatabaseExport | null>;
  readMedia?(profile: string, conversation: string, id: string, signal: AbortSignal, part?: number, refreshCache?: boolean, sourceRef?: string): Promise<Blob>;
}

export const Transport = createContext<WeComTransport | null>(null);
export function useTransport() {
  const transport = useContext(Transport);
  if (!transport) throw Error('WeCom transport is required');
  return transport;
}
