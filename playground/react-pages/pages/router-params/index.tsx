import { Link } from '@void/react';

export default function RouterParamsIndex() {
  return (
    <main>
      <h1>Router Params</h1>
      <p>This page links to a loaderless dynamic route.</p>
      <Link href="/router-params/alpha" prefetch="hover">
        Open alpha
      </Link>
    </main>
  );
}
