import { noticeModel, type UpdatePhase } from "./noticeModel";

type Props = {
  phase: UpdatePhase;
  onUpdate: () => void;
  onDismiss: () => void;
};

export default function UpdateNotice({ phase, onUpdate, onDismiss }: Props) {
  const model = noticeModel(phase);
  if (!model) return null;
  return (
    <div className="update-notice" role="status" aria-live="polite" aria-busy={model.busy}>
      <div className="update-notice-copy">
        <p className="update-notice-title">{model.title}</p>
        {model.detail ? <p className="update-notice-detail">{model.detail}</p> : null}
        {model.percent != null ? (
          <div className="update-notice-bar" aria-hidden="true">
            <span style={{ width: `${model.percent}%` }} />
          </div>
        ) : null}
      </div>
      {model.primary || model.secondary ? (
        <div className="update-notice-actions">
          {model.secondary ? (
            <button type="button" onClick={onDismiss}>
              {model.secondary}
            </button>
          ) : null}
          {model.primary ? (
            <button type="button" className="primary" onClick={onUpdate}>
              {model.primary}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
