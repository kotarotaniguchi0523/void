import { createLinkState, type LinkActiveMatch } from 'void/pages-client';
import type { Href } from 'void/routes';
import { useNavigation } from './use-navigation.ts';
import { useRouter } from './use-router.ts';

export function useLinkState(
  href: Href | (() => Href),
  options?: { activeMatch?: LinkActiveMatch },
): ReturnType<typeof createLinkState> {
  return createLinkState(useRouter(), useNavigation(), href, options);
}
