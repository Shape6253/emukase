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

  navigate(route: PageRoute): boolean {
    if (this.navigationDisabled()) return false;
    window.history.pushState(window.history.state, "", route === "library" ? "#/library" : "#/");
    this.route = route;
    return true;
  }

  destroy(): void {
    window.removeEventListener("hashchange", this.onHashChange);
  }
}
