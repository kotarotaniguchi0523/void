import { defineHandler } from 'void';

export const GET = defineHandler((c) => c.redirect('/users/1'));
