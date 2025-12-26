import { Notyf } from 'notyf'

let notyfInstance = null

function getNotyf() {
  if (!notyfInstance) {
    notyfInstance = new Notyf({
      ripple: false,
      duration: 3500,
      types: [
        {
          type: 'warning',
          background: '#f59e0b',
          icon: {
            className: 'notyf__icon--warning',
            tagName: 'i',
            text: ''
          }
        }
      ]
    })
  }
  return notyfInstance
}

export function useNotification() {
  const notyf = getNotyf()

  return {
    notyf,
    success: (message) => notyf.success(message),
    error: (message) => notyf.error(message),
    warning: (message) => notyf.open({ type: 'warning', message })
  }
}
