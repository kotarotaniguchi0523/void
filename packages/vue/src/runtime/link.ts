import {
  linkPrefetchAttributes,
  linkStateAttributes,
  type BaseLinkProps,
  type LinkActiveMatch,
  type NavigationState,
  type VoidRouter,
} from 'void/pages-client';
import type { Href } from 'void/routes';
import {
  computed,
  defineComponent,
  h,
  inject,
  type AnchorHTMLAttributes,
  type DefineSetupFnComponent,
  type ExtractPublicPropTypes,
  type PropType,
} from 'vue';

type LinkProps = BaseLinkProps & Omit<AnchorHTMLAttributes, keyof BaseLinkProps>;

const linkPropOptions = {
  href: { type: String as PropType<Href>, required: true },
  prefetch: {
    type: [Boolean, String, Array] as PropType<BaseLinkProps['prefetch']>,
    default: undefined,
  },
  cacheFor: {
    type: [Number, String, Array] as PropType<BaseLinkProps['cacheFor']>,
    default: undefined,
  },
  activeMatch: { type: String as PropType<LinkActiveMatch>, default: undefined },
  // The explicit default keeps an absent prop undefined: Vue would cast it to false.
  viewTransition: { type: Boolean, default: undefined },
} as const;

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const linkPropsMatchRuntime: Same<
  ExtractPublicPropTypes<typeof linkPropOptions>,
  BaseLinkProps
> = true;
void linkPropsMatchRuntime;

const LinkComponent = defineComponent({
  name: 'Link',
  inheritAttrs: false,
  props: linkPropOptions,
  setup(props, { slots, attrs }) {
    const router = inject<VoidRouter | null>('__void_router', null);
    const navigation = inject<NavigationState | null>('__void_navigation', null);
    const state = computed(() =>
      linkStateAttributes(router, navigation, props.href, props.activeMatch),
    );
    return () =>
      h(
        'a',
        {
          href: props.href,
          ...linkPrefetchAttributes(router, {
            prefetch: props.prefetch,
            cacheFor: props.cacheFor,
            viewTransition: props.viewTransition,
            reloadDocument: Object.hasOwn(attrs, 'data-void-reload'),
          }),
          ...state.value,
          ...attrs,
        },
        slots.default?.(),
      );
  },
});

export const Link: DefineSetupFnComponent<LinkProps> =
  LinkComponent as DefineSetupFnComponent<LinkProps>;
