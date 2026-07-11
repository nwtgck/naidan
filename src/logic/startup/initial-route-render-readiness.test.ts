import { describe, expect, it, vi } from 'vitest';
import { createInitialRouteRenderReadinessCoordinator } from './initial-route-render-readiness';

describe('initial route render readiness', () => {
  it('reports an ordinary route ready as soon as it mounts', () => {
    const onReady = vi.fn();
    const coordinator = createInitialRouteRenderReadinessCoordinator({
      onReady,
      onFailure: vi.fn(),
    });

    coordinator.reportRouteMounted({ routeKey: '/chat' });

    expect(onReady).toHaveBeenCalledOnce();
  });

  it('waits for an asynchronous route claim after the route mounts', () => {
    const onReady = vi.fn();
    const coordinator = createInitialRouteRenderReadinessCoordinator({
      onReady,
      onFailure: vi.fn(),
    });
    const claim = coordinator.claim({ routeKey: '/chat/chat-1' });

    coordinator.reportRouteMounted({ routeKey: '/chat/chat-1' });
    expect(onReady).not.toHaveBeenCalled();

    claim.reportReady();
    expect(onReady).toHaveBeenCalledOnce();
  });

  it('lets a redirect replacement route become ready without settling the blank redirect page', () => {
    const onReady = vi.fn();
    const coordinator = createInitialRouteRenderReadinessCoordinator({
      onReady,
      onFailure: vi.fn(),
    });
    const redirectClaim = coordinator.claim({ routeKey: '/settings' });

    coordinator.reportRouteMounted({ routeKey: '/settings' });
    redirectClaim.cancel();
    expect(onReady).not.toHaveBeenCalled();

    coordinator.reportRouteMounted({ routeKey: '/settings/connection' });
    expect(onReady).toHaveBeenCalledOnce();
  });

  it('reports failure only for the route still mounted behind the startup lock', () => {
    const onFailure = vi.fn();
    const coordinator = createInitialRouteRenderReadinessCoordinator({
      onReady: vi.fn(),
      onFailure,
    });
    const staleClaim = coordinator.claim({ routeKey: '/chat/chat-1' });

    coordinator.reportRouteMounted({ routeKey: '/chat/chat-1' });
    coordinator.reportRouteMounted({ routeKey: '/chat/chat-2' });
    staleClaim.reportFailure({ error: new Error('stale failure') });

    expect(onFailure).not.toHaveBeenCalled();
  });

  it('fails when the currently mounted asynchronous route cannot prepare', () => {
    const onFailure = vi.fn();
    const error = new Error('open chat failed');
    const coordinator = createInitialRouteRenderReadinessCoordinator({
      onReady: vi.fn(),
      onFailure,
    });
    const claim = coordinator.claim({ routeKey: '/chat/chat-1' });

    coordinator.reportRouteMounted({ routeKey: '/chat/chat-1' });
    claim.reportFailure({ error });

    expect(onFailure).toHaveBeenCalledWith({ error });
  });
});
