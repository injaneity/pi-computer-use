import { source } from '@/lib/source';
import { getMDXComponents } from '@/mdx-components';
import { createRelativeLink } from 'fumadocs-ui/mdx';
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from 'fumadocs-ui/page';
import { ArrowUpRight } from 'lucide-react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

export default async function Page(props: { params: Promise<{ slug?: string[] }> }) {
  const { slug = [] } = await props.params;
  const page = source.getPage(slug);
  if (!page) notFound();

  const MDXContent = page.data.body;
  const filePath = slug.length === 0 ? 'index.mdx' : `${slug.join('/')}.mdx`;
  const section = slug[0] ?? 'system';

  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      {slug.length > 0 && (
        <header className="quiet-page-header">
          <div className="quiet-page-meta">
            <span><i className="signal signal-active" /> {section}</span>
            <a
              href={`https://github.com/injaneity/pi-computer-use/blob/main/docs/content/docs/${filePath}`}
              target="_blank"
              rel="noreferrer"
            >
              source <ArrowUpRight aria-hidden="true" />
            </a>
          </div>
          <DocsTitle>{page.data.title}</DocsTitle>
          <DocsDescription>{page.data.description}</DocsDescription>
        </header>
      )}
      <DocsBody className={slug.length === 0 ? 'quiet-home-body' : undefined}>
        <MDXContent
          components={getMDXComponents({
            a: createRelativeLink(source, page),
          })}
        />
      </DocsBody>
    </DocsPage>
  );
}

export function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(props: {
  params: Promise<{ slug?: string[] }>;
}): Promise<Metadata> {
  const { slug = [] } = await props.params;
  const page = source.getPage(slug);
  if (!page) notFound();
  return {
    title: page.data.title,
    description: page.data.description,
  };
}
