// The skip link at the top of every page, and the id of the main content it skips to.

export const MAIN_CONTENT_ID = "main";

export function SkipLink() {
  return (
    <a className="skip" href={`#${MAIN_CONTENT_ID}`}>
      Skip to content
    </a>
  );
}

