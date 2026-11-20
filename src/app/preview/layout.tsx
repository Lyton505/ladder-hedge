import { notFound } from "next/navigation";

/**
 * Layout for `/preview`, the component preview with fixed sample data. The preview is a
 * development aid: its sample figures sit under "Live" badges, so production builds answer
 * 404 for it instead of serving it.
 *
 * @param {{ children: React.ReactNode }} props - Layout props.
 * @param {React.ReactNode} props.children - The preview page.
 * @returns {React.ReactNode} The page in development.
 * @throws {Error} Next's not-found signal in production builds, which renders the 404 page.
 */
export default function PreviewLayout({ children }: { children: React.ReactNode }) {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }
  return children;
}
