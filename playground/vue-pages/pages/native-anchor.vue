<script setup lang="ts">
import { createLinkClickHandler, useLinkState, useRouter } from '@void/vue';
if (typeof document !== 'undefined' && document.documentElement.hasAttribute('data-fail-route-render')) {
  throw new Error('Native anchor render failed');
}
const state = useLinkState('/users/1?anchor-prefetch=1');
const current = useLinkState('/native-anchor');
const replace = createLinkClickHandler(useRouter(), { replace: true, preserveScroll: true });
</script>

<template>
  <main style="min-height: 2500px">
    <h1>Native anchor</h1>
    <a href="/native-anchor" data-testid="anchor-current" v-bind="current.attributes">Current</a>
    <a
      href="/users/1?anchor-prefetch=1"
      data-testid="anchor-prefetch"
      data-void-prefetch="hover"
      data-void-cache-for="30s"
      v-bind="state.attributes"
      >Prefetch user</a
    >
    <a href="/users/1?anchor-prefetch=1" data-testid="anchor-duplicate" v-bind="state.attributes"
      >Same user</a
    >
    <a href="/users/2" data-testid="anchor-blocked" @click="(event) => event.preventDefault()">Blocked</a>
    <a href="/native-anchor?replace=1" data-testid="anchor-replace" @click="replace"
      >Replace in place</a
    >
  </main>
</template>
