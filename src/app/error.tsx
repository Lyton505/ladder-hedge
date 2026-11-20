"use client";

import { useEffect } from "react";

/** Props Next.js passes to a route error boundary. */
interface RouteErrorProps {
  /** The thrown value; a Client Component may throw something that is not an Error. */
  error: unknown;
  /** Re-fetches and re-renders the segment. */
  retry: () => void;
}

/**
 * Last-resort fallback for the page: shown only if rendering throws, so a fault never
 * leaves a blank screen. Engine errors are normally caught earlier and shown in place.
 *
 * @param {RouteErrorProps} props - Component props.
 * @param {unknown} props.error - The thrown value.
 * @param {() => void} props.retry - Retries rendering the page.
 * @returns {JSX.Element} A readable error message with a retry button.
 */
export default function RouteError({ error, retry }: RouteErrorProps) {
  const message = error instanceof Error ? error.message : String(error);

  useEffect(() => {
    console.error(`[ladder-hedge] page error: ${message}`);
  }, [message]);

  return (
    <main className="mx-auto flex w-full max-w-[720px] flex-col gap-3 px-5 py-16 sm:px-8">
      <h1 className="stretch-wide text-2xl font-bold tracking-tight">Ladder Hedge</h1>
      <section role="alert" className="flex flex-col gap-2 rounded-[6px] border border-alarm/30 bg-alarm-tint px-5 py-4">
        <h2 className="stretch-semiwide text-[15px] font-semibold text-alarm">The page could not be shown</h2>
        <p className="text-sm leading-relaxed text-ink">{message}</p>
        <button
          type="button"
          onClick={() => retry()}
          className="self-start text-sm font-medium text-cobalt underline decoration-cobalt/40 underline-offset-4 hover:decoration-cobalt"
        >
          Try again
        </button>
      </section>
    </main>
  );
}
