import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react'

import { FieldFrame, useFieldFrame } from '../internal/FieldFrame'
import { classNames } from '../internal/classNames'

export interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  description?: ReactNode
  error?: ReactNode
  label: ReactNode
}

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  {
    className,
    description,
    error,
    id,
    label,
    required,
    'aria-describedby': ariaDescribedBy,
    'aria-invalid': ariaInvalid,
    ...inputProps
  },
  ref
) {
  const field = useFieldFrame({ id, describedBy: ariaDescribedBy, description, error })

  return (
    <FieldFrame description={description} error={error} label={label} required={required} state={field}>
      <input
        {...inputProps}
        aria-describedby={field.describedBy}
        aria-invalid={field.invalid ? true : ariaInvalid}
        className={classNames('fui-field__control', 'fui-text-input', className)}
        id={field.controlId}
        ref={ref}
        required={required}
      />
    </FieldFrame>
  )
})
