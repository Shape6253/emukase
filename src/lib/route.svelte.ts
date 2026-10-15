export type PageRoute = "setup" | "library";

/** Hash routing keeps deep links working on static hosting without server rewrites. */
export function pageRouteFromHash(hash: string): PageRoute {
  return hash === "#/library" ? "library" : "setup";
}

export class PageRouter {
  route = $state<PageRoute>(pageRouteFromHash(window.location.hash));

  private readonly onHashChange = (): void => {
    this.route = pageRouteFromHash(window.location.hash);
  };

  constructor() {
    window.addEventListener("hashchange", this.onHashChange);
  }

  destroy(): void {
    window.removeEventListener("hashchange", this.onHashChange);
  }
}
