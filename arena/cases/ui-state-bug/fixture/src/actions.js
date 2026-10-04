export const ADD_ITEM = 'todo/add'
export const REMOVE_ITEM = 'todo/remove'
export const TOGGLE_DONE = 'todo/toggleDone'
export const TOGGLE_SELECT = 'todo/toggleSelect'
export const SELECT_ALL_VISIBLE = 'todo/selectAllVisible'
export const CLEAR_SELECTION = 'todo/clearSelection'
export const SET_FILTER = 'todo/setFilter'
export const CLEAR_FILTER = 'todo/clearFilter'
export const DELETE_SELECTED = 'todo/deleteSelected'
export const MARK_SELECTED_DONE = 'todo/markSelectedDone'

export const addItem = (item) => ({ type: ADD_ITEM, item })
export const removeItem = (id) => ({ type: REMOVE_ITEM, id })
export const toggleDone = (id) => ({ type: TOGGLE_DONE, id })
export const toggleSelect = (id) => ({ type: TOGGLE_SELECT, id })
export const selectAllVisible = () => ({ type: SELECT_ALL_VISIBLE })
export const clearSelection = () => ({ type: CLEAR_SELECTION })
export const setFilter = (patch) => ({ type: SET_FILTER, patch })
export const clearFilter = () => ({ type: CLEAR_FILTER })
export const deleteSelected = () => ({ type: DELETE_SELECTED })
export const markSelectedDone = () => ({ type: MARK_SELECTED_DONE })
