import { docs } from '@/.source';
import { loader } from 'fumadocs-core/source';
import { icons } from 'lucide-react';
import { createElement } from 'react';

export const source = loader({
  baseUrl: '/',
  source: docs.toFumadocsSource(),
  icon(icon) {
    if (!icon || !(icon in icons)) return;
    return createElement(icons[icon as keyof typeof icons]);
  },
});
