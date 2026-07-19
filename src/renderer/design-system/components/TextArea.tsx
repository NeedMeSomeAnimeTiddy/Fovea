import { forwardRef, type ReactNode, type TextareaHTMLAttributes } from 'react'

import { FieldFrame, useFieldFrame } from '../internal/FieldFrame'
import { classNames } from '../internal/classNames'

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  description?: ReactNode
  error?: ReactNode
  label: ReactNode
  resize?: 'none' | 'vertical' | 'both'
}

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  {
    className,
    description,
    error,
    id,
    label,
    required,
    resize = 'vertical',
    'aria-describedby': ariaDescribedBy,
    'aria-invalid': ariaInvalid,
    ...textAreaProps
  },
  ref
) {
  const field = useFieldFrame({ id, describedBy: ariaDescribedBy, description, error })

  return (
    <FieldFrame description={description} error={error} label={label} required={required} state={field}>
      <textarea
        {...textAreaProps}
        aria-describedby={field.describedBy}
        aria-invalid={field.invalid ? true : ariaInvalid}
        className={classNames('fui-field__control', 'fui-text-area', className)}
        data-resize={resize}
        id={field.controlId}
        ref={ref}
        required={required}
      />
    </FieldFrame>
  )
})
