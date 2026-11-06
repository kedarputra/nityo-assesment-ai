export const MAIN_CONTENT_ID = "main";

export function SkipLink() {
  return (
    <a className="skip" href={`#${MAIN_CONTENT_ID}`}>
      Skip to content
    </a>
  );
}

export function SiteHeader() {
  return (
    <header className="top">
      <span className="wordmark" translate="no">
        Harbor Point <span>Order desk</span>
      </span>
    </header>
  );
}
