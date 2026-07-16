import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { source } from '@/lib/source';
import { Brand, DocsFooter } from '@/components/brand';
import type { ReactNode } from 'react';

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout
      tree={source.pageTree}
      nav={{ title: <Brand />, url: '/' }}
      sidebar={{ footer: <DocsFooter />, defaultOpenLevel: 0, collapsible: true }}
      themeSwitch={{ enabled: false }}
      githubUrl="https://github.com/injaneity/pi-computer-use"
      containerProps={{ className: 'quiet-docs-shell' }}
    >
      {children}
    </DocsLayout>
  );
}
