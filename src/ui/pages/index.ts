import type { PageDefinition } from '../context';
import { debugPage } from './debug';
import { effectsPage } from './effects';
import { lyricsPage } from './lyrics';
import { pluginsPage } from './plugins';
import { renderersPage } from './renderers';
import { settingsPage } from './settings';

/**
 * Registration order is the sidebar order and the Ctrl+N mapping. Plugin roles
 * that people interact with daily get their own page under 插件; everything else
 * is managed in 全部插件.
 */
export const pages: PageDefinition[] = [lyricsPage, renderersPage, effectsPage, pluginsPage, settingsPage, debugPage];
