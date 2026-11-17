import { Link, useShared } from '@void/solid';
import type { JSX } from 'solid-js';

export default function Layout(props: { children: JSX.Element }) {
  const shared = useShared();
  return (
    <div>
      <nav>
        <Link href="/" prefetch="hover">
          Home
        </Link>{' '}
        |{' '}
        <Link href="/users" activeMatch="prefix" prefetch="hover">
          Users
        </Link>{' '}
        |{' '}
        <Link href="/blog" prefetch="hover">
          Blog
        </Link>{' '}
        |{' '}
        <Link href="/deferred" prefetch="hover">
          Deferred
        </Link>{' '}
        | <span>{shared.appName}</span>
      </nav>
      <hr />
      {props.children}
    </div>
  );
}
