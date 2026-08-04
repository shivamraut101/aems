import type { ReactElement, ReactNode } from "react";

interface NoticeProps {
  tone: "warn" | "plain";
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}

/**
 * A block that explains a condition the employee may need to act on.
 *
 * `role="status"` rather than `alert`: these appear on a screen the employee opened
 * deliberately and describe an ongoing state, so interrupting whatever they are
 * reading is the wrong behaviour.
 */
export function Notice({ tone, title, children, action }: NoticeProps): ReactElement {
  return (
    <section className={tone === "warn" ? "notice notice--warn" : "notice"} role="status">
      <h3 className="notice__title">{title}</h3>
      {children !== undefined && <p className="notice__body">{children}</p>}
      {action !== undefined && <div className="notice__action">{action}</div>}
    </section>
  );
}
