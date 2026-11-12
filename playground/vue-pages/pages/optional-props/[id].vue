<script setup lang="ts">
import { createLinkClickHandler, useRouter } from '@void/vue';
import { ref } from 'vue';

const props = defineProps<{ title: string; note?: string }>();
const draft = ref('');
const keepState = createLinkClickHandler(useRouter(), { preserveState: true });
</script>

<template>
  <section id="optional-props">
    <h1>{{ props.title }}</h1>
    <p>{{ props.note }}</p>
    <label>Draft <input v-model="draft" /></label>
    <a href="/optional-props/second" @click="keepState">Show note</a>
  </section>
</template>
