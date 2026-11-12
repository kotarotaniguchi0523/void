import { Link, createLinkClickHandler, useNavigation, useRouter } from '@void/react';
import { useRef, useState } from 'react';
import type { Props } from './link-behavior.server.ts';

type LinkBehaviorWindow = Window & {
  __linkOnClick?: boolean;
  __preventedClick?: boolean;
};

export default function LinkBehaviorPage({ title, absoluteUrl, protocolRelativeUrl }: Props) {
  const [abortTestStatus, setAbortTestStatus] = useState('Not run');

  const router = useRouter();
  const navigation = useNavigation();
  const abortTestCleanupRef = useRef<() => void>(() => {});

  const runAbortNavigationTest = () => {
    const observedErrors: Array<string> = [];
    const recordError = (error: unknown) => {
      observedErrors.push(error instanceof Error ? error.message : String(error));
    };
    const onError = (event: ErrorEvent) => {
      recordError(event.error ?? event.message);
    };
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      recordError(event.reason);
    };
    const cleanup = () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
      abortTestCleanupRef.current = () => {};
    };

    abortTestCleanupRef.current();
    abortTestCleanupRef.current = cleanup;
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onUnhandledRejection);
    setAbortTestStatus('Running...');

    void router.visit('/link-behavior?abort-slow=1', {
      resolveOn: router.query.get('resolveOn') === 'data' ? 'data' : undefined,
    });
    window.setTimeout(() => {
      void router.visit('#abort-test-complete');
    }, 50);
    window.setTimeout(() => {
      cleanup();
      setAbortTestStatus(
        observedErrors.some(
          (error) => error.includes('Navigation aborted') || error.includes('AbortError'),
        )
          ? `Failed: ${observedErrors.join(', ')}`
          : 'Passed: interrupted GET navigation did not surface an abort error.',
      );
    }, 800);
  };

  return (
    <div>
      <h1>{title}</h1>
      <p>
        <Link href={absoluteUrl} data-testid="absolute-current-link">
          Current page (absolute)
        </Link>
        <Link href={protocolRelativeUrl} data-testid="protocol-relative-current-link">
          Current page (protocol-relative)
        </Link>
        <Link href="http://localhost/link-behavior" data-testid="external-localhost-link">
          External localhost
        </Link>
      </p>
      <p>
        <button
          data-testid="typed-visit"
          onClick={() =>
            router.visit({ pathname: '/users/:id', params: { id: '2' }, query: { tab: 'visit' } })
          }
        >
          Typed visit
        </button>
      </p>

      <p>
        <Link href="?view=compact" data-testid="query-only-link">
          Query-only link
        </Link>
      </p>

      <p>
        <Link href="/link-redirect" data-testid="server-redirect-link">
          Server redirect
        </Link>
        <Link href="/link-rewrite" data-testid="server-rewrite-link">
          Server rewrite
        </Link>
        <Link href="/api/health" data-testid="non-page-link">
          Not a page
        </Link>
      </p>

      <p>
        <Link
          href="/users"
          data-testid="onclick-link"
          onClick={() => {
            (window as LinkBehaviorWindow).__linkOnClick = true;
          }}
        >
          User handler then SPA
        </Link>
      </p>

      <p>
        <Link
          href="/users"
          data-testid="prevented-click-link"
          onClick={(event) => {
            event.preventDefault();
            (window as LinkBehaviorWindow).__preventedClick = true;
          }}
        >
          Prevented click
        </Link>
      </p>

      <p>
        <a
          href="/users"
          data-testid="replace-link"
          onClick={createLinkClickHandler(router, { replace: true })}
        >
          Replace with users
        </a>
      </p>

      <p>
        <a href="/users" data-testid="reload-link" data-void-reload>
          Reload document
        </a>
      </p>

      <p>
        <Link href="/users" data-testid="blank-link" target="_blank">
          Open users in a new tab
        </Link>
      </p>

      <p>
        <Link href="/users" data-testid="download-link" download="users.html">
          Download users
        </Link>
      </p>

      <p>
        <a href="#plain-hash-target" data-testid="plain-hash-link">
          Plain hash target
        </a>
      </p>
      <p data-testid="navigation-state">{navigation.state}</p>

      <section>
        <h2>Aborted GET navigation check</h2>
        <button type="button" onClick={runAbortNavigationTest}>
          Run interrupted navigation check
        </button>
        <p data-testid="abort-navigation-status">{abortTestStatus}</p>
      </section>

      <section id="plain-hash-target">
        <h2>Plain hash target</h2>
      </section>

      <section id="abort-test-complete">
        <h2>Abort test complete</h2>
      </section>
    </div>
  );
}
