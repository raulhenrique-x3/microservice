import { Body, Controller, Get, Param, Post, UploadedFile, UseInterceptors, HttpCode, ParseUUIDPipe } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JobsService } from './jobs.service.js';
import { CreateJobDto } from './create-job.dto.js';

@Controller('jobs')
export class JobsController {
  constructor(private jobs: JobsService) {}

  @Post()
  @HttpCode(202)
  @UseInterceptors(FileInterceptor('file'))
  create(@UploadedFile() file: Express.Multer.File, @Body() dto: CreateJobDto) {
    return this.jobs.create(file, dto.targetFormat, dto.notifyEmail);
  }

  @Get(':jobId')
  get(@Param('jobId', ParseUUIDPipe) jobId: string) {
    return this.jobs.get(jobId);
  }
}
