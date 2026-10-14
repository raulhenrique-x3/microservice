import { IsEmail, IsIn } from 'class-validator';
import { TARGET_FORMATS } from '../media/media.js';

export class CreateJobDto {
  @IsIn(TARGET_FORMATS as unknown as string[], { message: 'formato de destino inválido' })
  targetFormat: string;

  @IsEmail({}, { message: 'e-mail inválido' })
  notifyEmail: string;
}
