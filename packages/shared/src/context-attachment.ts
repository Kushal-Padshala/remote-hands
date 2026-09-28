import { z } from 'zod';

export type ContextAttachmentType = 'browser_tab' | 'app_window' | 'local_file';

export interface BrowserTabAttachment {
  type: 'browser_tab';
  id: string;
  browser: string;
  profile?: string | undefined;
  title: string;
  url: string;
  tabIndex?: number | undefined;
}

export interface AppWindowAttachment {
  type: 'app_window';
  id: string;
  app: string;
  title?: string | undefined;
  windowId?: number | string | undefined;
}

export interface LocalFileAttachment {
  type: 'local_file';
  id: string;
  path: string;
  name: string;
  sizeBytes?: number | undefined;
  isDir?: boolean | undefined;
}

export type ContextAttachment = BrowserTabAttachment | AppWindowAttachment | LocalFileAttachment;

export const browserTabAttachmentSchema = z.object({
  type: z.literal('browser_tab'),
  id: z.string(),
  browser: z.string(),
  profile: z.string().optional(),
  title: z.string(),
  url: z.string(),
  tabIndex: z.number().int().optional(),
});

export const appWindowAttachmentSchema = z.object({
  type: z.literal('app_window'),
  id: z.string(),
  app: z.string(),
  title: z.string().optional(),
  windowId: z.union([z.number(), z.string()]).optional(),
});

export const localFileAttachmentSchema = z.object({
  type: z.literal('local_file'),
  id: z.string(),
  path: z.string(),
  name: z.string(),
  sizeBytes: z.number().optional(),
  isDir: z.boolean().optional(),
});

export const contextAttachmentSchema = z.discriminatedUnion('type', [
  browserTabAttachmentSchema,
  appWindowAttachmentSchema,
  localFileAttachmentSchema,
]);

export interface ContextBrowserProfile {
  id: string;
  name: string;
  tabs: Array<{
    id: string;
    title: string;
    url: string;
    tabIndex?: number | undefined;
  }>;
}

export interface ContextBrowserTarget {
  id: string;
  name: string;
  profiles: ContextBrowserProfile[];
}

export interface ContextAppTarget {
  id: string;
  name: string;
  windows: Array<{
    id: string;
    title: string;
  }>;
}

export interface ContextFileTarget {
  id: string;
  name: string;
  path: string;
  isDir: boolean;
}

export interface ContextHierarchy {
  browsers: ContextBrowserTarget[];
  apps: ContextAppTarget[];
  files: ContextFileTarget[];
}
