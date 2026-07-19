// SPDX-License-Identifier: AGPL-3.0-or-later

import * as Modal from '@app/features/app/components/dialogs/Modal';
import {useFormSubmit} from '@app/features/app/hooks/useFormSubmit';
import type {CastCharacter} from '@app/features/cast/commands/CastCommands';
import Cast from '@app/features/cast/state/Cast';
import {CANCEL_DESCRIPTOR} from '@app/features/i18n/utils/CommonMessageDescriptors';
import {Button} from '@app/features/ui/button/Button';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import * as ToastCommands from '@app/features/ui/commands/ToastCommands';
import {Form} from '@app/features/ui/components/form/Form';
import {Input} from '@app/features/ui/components/form/FormInput';
import {msg} from '@lingui/core/macro';
import {Trans, useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';
import type React from 'react';
import {useCallback, useRef} from 'react';
import {useForm} from 'react-hook-form';

const EDIT_OVERRIDE_DESCRIPTOR = msg({
	message: 'Edit character display',
	comment: 'Title of the cast character override modal. Keep it concise.',
});
const NICKNAME_DESCRIPTOR = msg({
	message: 'Nickname',
	comment: 'Short label in the cast character override modal. Keep it concise.',
});
const PFP_URL_DESCRIPTOR = msg({
	message: 'Avatar URL',
	comment: 'Short label in the cast character override modal. Keep it concise.',
});
const INVALID_URL_DESCRIPTOR = msg({
	message: 'Enter a valid http or https URL.',
	comment: 'Validation error shown when the avatar URL in the cast override modal is not a usable URL.',
});
const SAVE_FAILED_DESCRIPTOR = msg({
	message: 'Failed to save character display. Try again.',
	comment: 'Error shown when saving a cast character override fails.',
});
const SAVE_DESCRIPTOR = msg({
	message: 'Save',
	comment: 'Button label in the cast character override modal. Keep it concise.',
});

/**
 * Mirrors the backend's own validation rather than being merely decorative: the route accepts
 * z.string().url() capped at 2048, so anything this lets through would only fail again server
 * side. Empty is allowed and means "clear the override".
 */
const MAX_NICKNAME_LENGTH = 100;
const MAX_PFP_URL_LENGTH = 2048;

function isUsableUrl(value: string): boolean {
	try {
		const parsed = new URL(value);
		return parsed.protocol === 'http:' || parsed.protocol === 'https:';
	} catch {
		return false;
	}
}

interface OverrideFormValues {
	nickname: string;
	pfpUrl: string;
}

export const CastEditOverrideModal: React.FC<{
	guildId: string;
	character: CastCharacter;
	currentNickname: string | null;
	currentPfpUrl: string | null;
}> = observer(({guildId, character, currentNickname, currentPfpUrl}) => {
	const {i18n} = useLingui();
	const form = useForm<OverrideFormValues>({
		defaultValues: {
			nickname: currentNickname ?? '',
			pfpUrl: currentPfpUrl ?? '',
		},
	});
	const nicknameField = form.register('nickname', {maxLength: MAX_NICKNAME_LENGTH});
	const pfpUrlField = form.register('pfpUrl', {
		maxLength: MAX_PFP_URL_LENGTH,
		validate: (value: string) => (value.trim() === '' || isUsableUrl(value.trim()) ? true : i18n._(INVALID_URL_DESCRIPTOR)),
	});
	const nicknameInputRef = useRef<HTMLInputElement | null>(null);

	const handleCancel = useCallback(() => {
		form.reset();
		form.clearErrors();
		ModalCommands.pop();
	}, [form]);

	const onSubmit = useCallback(
		async (data: OverrideFormValues) => {
			const nickname = data.nickname.trim();
			const pfpUrl = data.pfpUrl.trim();
			// Empty clears the field rather than leaving it untouched, which is what the user
			// means by deleting the contents of an input they can see.
			const ok = await Cast.updateOverride(guildId, character.id, {
				nickname: nickname === '' ? null : nickname,
				pfpUrl: pfpUrl === '' ? null : pfpUrl,
			});
			if (!ok) {
				form.setError('nickname', {message: i18n._(SAVE_FAILED_DESCRIPTOR)});
				return;
			}
			ModalCommands.pop();
			ToastCommands.createToast({
				type: 'success',
				children: <Trans>Updated character display</Trans>,
			});
		},
		[character.id, form, guildId, i18n],
	);

	const {handleSubmit, isSubmitting} = useFormSubmit({form, onSubmit, defaultErrorField: 'nickname'});

	return (
		<Modal.Root size="small" centered initialFocusRef={nicknameInputRef} data-flx="cast.edit-override-modal.modal-root">
			<Form form={form} onSubmit={handleSubmit} data-flx="cast.edit-override-modal.form.submit">
				<Modal.Header title={i18n._(EDIT_OVERRIDE_DESCRIPTOR)} data-flx="cast.edit-override-modal.modal-header" />
				<Modal.Content data-flx="cast.edit-override-modal.modal-content">
					<Modal.ContentLayout data-flx="cast.edit-override-modal.modal-content-layout">
						<Input
							type="text"
							label={i18n._(NICKNAME_DESCRIPTOR)}
							data-flx="cast.edit-override-modal.input.nickname"
							{...nicknameField}
							ref={(el) => {
								nicknameField.ref(el);
								nicknameInputRef.current = el;
							}}
							maxLength={MAX_NICKNAME_LENGTH}
							disabled={isSubmitting}
							autoFocus
							error={form.formState.errors.nickname?.message}
						/>
						<Input
							type="text"
							label={i18n._(PFP_URL_DESCRIPTOR)}
							data-flx="cast.edit-override-modal.input.pfp-url"
							{...pfpUrlField}
							maxLength={MAX_PFP_URL_LENGTH}
							disabled={isSubmitting}
							error={form.formState.errors.pfpUrl?.message}
						/>
					</Modal.ContentLayout>
				</Modal.Content>
				<Modal.Footer data-flx="cast.edit-override-modal.modal-footer">
					<Button
						type="button"
						variant="secondary"
						onClick={handleCancel}
						disabled={isSubmitting}
						data-flx="cast.edit-override-modal.button.cancel"
					>
						{i18n._(CANCEL_DESCRIPTOR)}
					</Button>
					<Button
						type="submit"
						variant="primary"
						submitting={isSubmitting}
						data-flx="cast.edit-override-modal.button.submit"
					>
						{i18n._(SAVE_DESCRIPTOR)}
					</Button>
				</Modal.Footer>
			</Form>
		</Modal.Root>
	);
});
