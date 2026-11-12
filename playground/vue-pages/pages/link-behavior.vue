<script setup lang="ts">
import { Link, createLinkClickHandler, useRouter } from '@void/vue';
import type { Props } from './link-behavior.server.ts';

defineProps<Props>();
const router = useRouter();
const replaceUsers = createLinkClickHandler(router, { replace: true });

type LinkBehaviorWindow = Window & {
  __linkOnClick?: boolean;
  __preventedClick?: boolean;
};

function setClicked() {
  (window as LinkBehaviorWindow).__linkOnClick = true;
}

function preventClick(event: Event) {
  event.preventDefault();
  (window as LinkBehaviorWindow).__preventedClick = true;
}
</script>

<template>
  <div>
    <h1>{{ title }}</h1>
    <p>
      <Link :href="absoluteUrl" data-testid="absolute-current-link">Current page (absolute)</Link>
      <Link :href="protocolRelativeUrl" data-testid="protocol-relative-current-link"
        >Current page (protocol-relative)</Link
      >
      <Link href="http://localhost/link-behavior" data-testid="external-localhost-link"
        >External localhost</Link
      >
    </p>
    <p>
      <button
        data-testid="typed-visit"
        @click="
          router.visit({ pathname: '/users/:id', params: { id: '2' }, query: { tab: 'visit' } })
        "
      >
        Typed visit
      </button>
    </p>

    <p>
      <Link href="?view=compact" data-testid="query-only-link">Query-only link</Link>
    </p>

    <p>
      <Link href="/link-redirect" data-testid="server-redirect-link">Server redirect</Link>
      <Link href="/link-rewrite" data-testid="server-rewrite-link">Server rewrite</Link>
      <Link href="/api/health" data-testid="non-page-link">Not a page</Link>
    </p>

    <p>
      <Link href="/users" data-testid="onclick-link" @click="setClicked">
        User handler then SPA
      </Link>
    </p>

    <p>
      <Link href="/users" data-testid="prevented-click-link" @click="preventClick">
        Prevented click
      </Link>
    </p>

    <p>
      <a href="/users" data-testid="replace-link" @click="replaceUsers">Replace with users</a>
    </p>

    <p>
      <a href="/users" data-testid="reload-link" data-void-reload>Reload document</a>
    </p>

    <p>
      <Link href="/users" data-testid="blank-link" target="_blank"> Open users in a new tab </Link>
    </p>

    <p>
      <Link href="/users" data-testid="download-link" download="users.html"> Download users </Link>
    </p>

    <p>
      <Link href="/link-behavior?tag=a&tag=b&page=2&active=true" data-testid="query-data-link">
        Query data
      </Link>
    </p>
  </div>
</template>
