export type PageRoute = "setup" | "library";

/** Hash routing keeps deep links working on static hosting without server rewrites. */
export function pageRouteFromHash(hash: string): PageRoute {
  return hash === "#/library" ? "library" : "setup";
}

export class PageRouter {
  route = $state<PageRoute>(pageRouteFromHash(window.location.hash));

  private readonly onHashChange = (): void => {
    if (this.navigationDisabled()) {
      window.history.replaceState(window.history.state, "", this.route === "library" ? "#/library" : "#/");
      return;
    }
    this.route = pageRouteFromHash(window.location.hash);
  };

  constructor(private readonly navigationDisabled: () => boolean) {
    window.addEventListener("hashchange", this.onHashChange);
  }

  destroy(): void {
    window.removeEventListener("hashchange", this.onHashChange);
  }
}
