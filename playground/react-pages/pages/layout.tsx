import { Link, useShared } from '@void/react';

export default function Layout({ children }: { children: React.ReactNode }) {
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
        |{' '}
        <Link href="/router-params" prefetch="hover">
          Router Params
        </Link>{' '}
        |{' '}
        <Link href="/live" prefetch="hover">
          Live
        </Link>{' '}
        |{' '}
        <Link href="/action-error" prefetch="hover">
          Form Lab
        </Link>{' '}
        |{' '}
        <Link href="/client-only" prefetch="hover">
          Client-only
        </Link>{' '}
        | <span>{shared.appName}</span>
      </nav>
      <hr />
      {children}
    </div>
  );
}
