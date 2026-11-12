import { defineHandler } from 'void';

export const GET = defineHandler((c) => c.rewrite('/users/2'));
