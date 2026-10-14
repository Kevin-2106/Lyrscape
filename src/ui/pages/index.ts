import type { PageDefinition } from '../context';
import { aboutPage } from './about';
import { lyricsPage } from './lyrics';
import { overlayPage } from './overlay';
import { pluginsPage } from './plugins';
import { stylePage } from './style';

/** Registration order is the sidebar order and the Ctrl+N mapping. */
export const pages: PageDefinition[] = [lyricsPage, stylePage, overlayPage, pluginsPage, aboutPage];
