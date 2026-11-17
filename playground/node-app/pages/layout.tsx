import { Link } from '@void/react';

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <nav>
        <Link href="/" prefetch="hover">
          Home
        </Link>{' '}
        |{' '}
        <Link href="/about" prefetch="hover">
          About
        </Link>
      </nav>
      <hr />
      {children}
    </div>
  );
}
