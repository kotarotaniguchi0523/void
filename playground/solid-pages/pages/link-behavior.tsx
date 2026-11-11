import { Link, createLinkClickHandler, useRouter } from '@void/solid';
import type { Props } from './link-behavior.server.ts';

type LinkBehaviorWindow = Window & {
  __boundClickData?: string;
  __boundClickEventType?: string;
  __linkOnClick?: boolean;
  __preventedClick?: boolean;
};

export default function LinkBehaviorPage(props: Props) {
  const router = useRouter();

  function setBoundClicked(label: string, event: MouseEvent) {
    event.preventDefault();
    const linkWindow = window as LinkBehaviorWindow;
    linkWindow.__boundClickData = label;
    linkWindow.__boundClickEventType = event.type;
  }

  return (
    <div>
      <h1>{props.title}</h1>
      <p>
        <Link href={props.absoluteUrl} data-testid="absolute-current-link">
          Current page (absolute)
        </Link>
        <Link href={props.protocolRelativeUrl} data-testid="protocol-relative-current-link">
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
          data-testid="bound-click-link"
          onClick={[setBoundClicked, 'bound-data']}
        >
          Bound click handler
        </Link>
      </p>

      <p>
        <Link
          href="/users"
          data-testid="prevented-click-link"
          onClick={(event: MouseEvent) => {
            event.preventDefault();
            (window as LinkBehaviorWindow).__preventedClick = true;
          }}
        >
          Prevented click
        </Link>
      </p>

      

      <p>
        <a href="/users" data-testid="replace-link" onClick={createLinkClickHandler(router, { replace: true })}>
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
        <Link href="/link-behavior?tag=a&tag=b&page=2&active=true" data-testid="query-data-link">
          Query data
        </Link>
      </p>


    </div>
  );
}
