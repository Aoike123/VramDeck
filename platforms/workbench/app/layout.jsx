import './globals.css';
import { cookies, headers } from 'next/headers';
import { resolveLocale } from './i18n.mjs';

export const metadata = {
  title: 'VramDeck · Few-GPU AI Control Plane',
  description:
    'Cross-platform 1–4 GPU multimodal AI resource manager, OpenAI/Media API, MCP & Engine Hub',
};

export default async function Layout({ children }) {
  let lang = 'en';
  try {
    const cookieStore = await cookies();
    const headerList = await headers();
    const cookieLocale =
      cookieStore.get('vramdeck_lang')?.value ??
      cookieStore.get('lang')?.value ??
      cookieStore.get('locale')?.value ??
      '';
    const acceptLanguage = headerList.get('accept-language') ?? '';
    lang = resolveLocale({
      lang: cookieLocale,
      cookieHeader: '',
      acceptLanguage,
    });
  } catch {
    lang = 'en';
  }
  return (
    <html lang={lang}>
      <body>{children}</body>
    </html>
  );
}
