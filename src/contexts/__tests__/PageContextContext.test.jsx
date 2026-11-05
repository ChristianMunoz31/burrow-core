import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, renderHook } from '@testing-library/react';
import {
  PageContextProvider,
  usePageContext,
  usePageContextReader,
  usePageData,
} from '../PageContextContext';

afterEach(cleanup);

function Page({ pageKey = 'todos', builder }) {
  usePageContext(pageKey, builder);
  return null;
}

function Reader({ onReader }) {
  onReader(usePageContextReader());
  return null;
}

function setup(ui) {
  let reader;
  const utils = render(
    <PageContextProvider>
      {ui}
      <Reader onReader={(r) => (reader = r)} />
    </PageContextProvider>,
  );
  return { ...utils, read: (key) => reader.readPageContext(key) };
}

describe('PageContextContext', () => {
  it('calls the builder only when read, not on register or re-render', () => {
    const builder = vi.fn(() => ({ n: 1 }));
    const { rerender, read } = setup(<Page builder={builder} />);
    expect(builder).not.toHaveBeenCalled();
    rerender(
      <PageContextProvider>
        <Page builder={builder} />
        <Reader onReader={() => {}} />
      </PageContextProvider>,
    );
    expect(builder).not.toHaveBeenCalled();
    const out = read('todos');
    expect(builder).toHaveBeenCalledTimes(1);
    expect(out.registered).toBe(true);
    expect(JSON.parse(out.context).data).toEqual({ n: 1 });
  });

  it('uses the latest closure after a re-render', () => {
    let reader;
    const tree = (value) => (
      <PageContextProvider>
        <Page builder={() => ({ value })} />
        <Reader onReader={(r) => (reader = r)} />
      </PageContextProvider>
    );
    const { rerender } = render(tree(1));
    rerender(tree(2));
    expect(JSON.parse(reader.readPageContext('todos').context).data).toEqual({ value: 2 });
  });

  it('unregisters on unmount and falls back to route/title', () => {
    let reader;
    const tree = (withPage) => (
      <PageContextProvider>
        {withPage && <Page builder={() => ({ a: 1 })} />}
        <Reader onReader={(r) => (reader = r)} />
      </PageContextProvider>
    );
    const { rerender } = render(tree(true));
    expect(reader.readPageContext('todos').registered).toBe(true);
    rerender(tree(false));
    const out = reader.readPageContext('todos');
    expect(out.registered).toBe(false);
    expect(JSON.parse(out.context).data).toEqual({ route: 'todos', title: 'Todos' });
  });

  it('a stale unregister does not delete a newer registration', () => {
    let reader;
    const tree = (second) => (
      <PageContextProvider>
        <Page key="a" builder={() => ({ who: 'first' })} />
        {second && <Page key="b" builder={() => ({ who: 'second' })} />}
        <Reader onReader={(r) => (reader = r)} />
      </PageContextProvider>
    );
    const { rerender } = render(tree(false));
    rerender(tree(true)); // second registers over the first
    expect(JSON.parse(reader.readPageContext('todos').context).data).toEqual({ who: 'second' });
    rerender(
      <PageContextProvider>
        <Page key="b" builder={() => ({ who: 'second' })} />
        <Reader onReader={(r) => (reader = r)} />
      </PageContextProvider>,
    ); // first unmounts: its unregister must not remove the second
    expect(reader.readPageContext('todos').registered).toBe(true);
  });

  it('is a silent no-op without a provider', () => {
    const builder = vi.fn(() => ({}));
    expect(() => render(<Page builder={builder} />)).not.toThrow();
    expect(builder).not.toHaveBeenCalled();
    const { result } = renderHook(() => usePageContextReader());
    expect(result.current.readPageContext('todos').registered).toBe(false);
  });

  it('a throwing builder yields the context-unavailable note', () => {
    const { read } = setup(
      <Page
        builder={() => {
          throw new Error('boom');
        }}
      />,
    );
    expect(JSON.parse(read('todos').context).data).toEqual({ error: 'context unavailable' });
  });

  it('passes the data signal to usePageData without re-rendering the page, and clears it on unmount', () => {
    const LIST = [{ id: 'a' }];
    let pageRenders = 0;
    let seen;
    const onRender = () => (pageRenders += 1);
    const onData = (v) => (seen = v);
    function DataPage({ data, onPage }) {
      onPage();
      usePageContext('notes', () => null, data);
      return null;
    }
    function Host({ onValue }) {
      onValue(usePageData('notes'));
      return null;
    }
    const tree = (page) => (
      <PageContextProvider>
        {page}
        <Host onValue={onData} />
      </PageContextProvider>
    );
    const { rerender } = render(tree(<DataPage data={LIST} onPage={onRender} />));
    expect(seen).toBe(LIST);
    const renders = pageRenders;
    // Registered with no records is `false`, distinct from no page registered (null).
    rerender(tree(<DataPage data={0} onPage={onRender} />));
    expect(seen).toBe(false);
    expect(pageRenders).toBe(renders + 1);
    rerender(tree(null));
    expect(seen).toBe(null);
  });

  it('usePageData is null without a provider', () => {
    const { result } = renderHook(() => usePageData('notes'));
    expect(result.current).toBe(null);
  });
});
